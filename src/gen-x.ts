/**
 * gen-x.ts
 * v0.5.0
 *
 * The Generation eXchange.
 * A single-threaded, queued generation engine with built-in budget management,
 * transient error handling, and reactive state.
 */

export interface GenerationState {
  status:
  | "idle"
  | "queued"
  | "generating"
  | "waiting_for_budget"
  | "waiting_for_user"
  | "completed"
  | "failed";
  error?: string;
  queueLength: number;

  // Budget Timer info
  budgetWaitEndTime?: number;
}

/** Why a `fastRejection: true` task was rejected without waiting.
 * - `"busy"`   — the engine was already processing or had queued work.
 * - `"budget"` — the input and/or output token allowance was insufficient.
 */
export type FastRejectionReason = "busy" | "budget";

/**
 * Thrown (as a promise rejection) by `generate()` when `fastRejection: true`
 * is set and the request would otherwise have been queued or parked in one of
 * the `waiting_for_*` states.
 *
 * Opportunistic background processors should catch this and drive their own
 * retry loop instead of occupying the engine — the UI never sees a queued or
 * waiting state for these tasks.
 */
export class FastRejectionError extends Error {
  /** Brand — survives module duplication across bundles, unlike `instanceof`. */
  public readonly isFastRejection = true as const;
  public readonly reason: FastRejectionReason;
  /** Milliseconds until the blocking budget is expected to replenish.
   * Only set for `reason === "budget"`; a hint for the caller's retry loop.
   * Note this ignores the user-interaction flag, so budget may still be
   * withheld after this delay until the user interacts with the app. */
  public readonly retryAfterMs?: number;

  constructor(reason: FastRejectionReason, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "FastRejectionError";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Type guard for fast-rejection failures from `generate()`. */
export function isFastRejection(e: unknown): e is FastRejectionError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as FastRejectionError).isFastRejection === true
  );
}

/** Context pinning for automatic context budgeting.
 * head = number of leading messages to keep (system prompt).
 * tail = number of trailing messages to keep (instruction + prefill).
 * Middle messages between head and tail are trimmed via RolloverHelper
 * when the total context exceeds the model's token budget.
 */
export type ContextPinning = { head: number; tail: number };

// Message factory for JIT (just-in-time) strategy building
export type MessageFactory = () => Promise<{
  messages: Message[];
  params?: Partial<GenerationParams>;
  contextPinning?: ContextPinning;
}>;

interface GenerationTask {
  id: string;
  messages: Message[] | null; // null if using factory
  messageFactory?: MessageFactory;
  params: GenerationParams & {
    maxRetries?: number;
    taskId?: string;
    fastRejection?: boolean;
  };
  contextPinning?: ContextPinning;
  callback?: (choices: GenerationChoice[], final: boolean) => void;
  behaviour?: "background" | "blocking";
  signal?: CancellationSignal;
  resolve: (value: GenerationResponse) => void;
  reject: (reason: any) => void;
}

export interface GenXHooks {
  /** Fires on every internal state change (replaces subscribe for store use) */
  onStateChange?(state: GenerationState): void;
  /** Fires when a queued task begins execution (picked off queue) */
  onTaskStarted?(taskId: string): void;
  /** Fires just before API call, after factory resolution */
  beforeGenerate?(taskId: string, messages: Message[]): void;
}

export class GenX {
  private queue: GenerationTask[] = [];
  private currentTask: GenerationTask | null = null;

  private _state: GenerationState = {
    status: "idle",
    queueLength: 0,
  };

  private listeners = new Set<(state: GenerationState) => void>();
  private hooks?: GenXHooks;

  constructor(hooks?: GenXHooks) {
    this.hooks = hooks;
    this.initBudgetListener();
  }

  // --- Public API ---

  public get state(): GenerationState {
    return { ...this._state };
  }

  public subscribe(listener: (state: GenerationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state); // Immediate update
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Queue a generation request.
   * Mirrors api.v1.generate parameters.
   *
   * When `messages` is a MessageFactory function, it will be called at execution
   * time (when the job is picked off the queue), enabling JIT strategy building.
   *
   * Set `params.fastRejection` for opportunistic background work: the request
   * never queues and never parks in a `waiting_for_*` state — it rejects
   * immediately with a `FastRejectionError` instead, leaving the caller to run
   * its own retry loop. See `isFastRejection()`.
   */
  public generate(
    messages: Message[] | MessageFactory,
    params: GenerationParams & {
      maxRetries?: number;
      taskId?: string;
      fastRejection?: boolean;
    },
    callback?: (choices: GenerationChoice[], final: boolean) => void,
    behaviour?: "background" | "blocking",
    signal?: CancellationSignal,
  ): Promise<GenerationResponse> {
    return new Promise((resolve, reject) => {
      // Fast rejection: never wait behind other work, and never touch the
      // shared state (a queued/waiting status would show up in the UI as if
      // the user had to act).
      if (params.fastRejection && (this.currentTask || this.queue.length > 0)) {
        reject(
          new FastRejectionError(
            "busy",
            `GenX busy: ${this.queue.length + (this.currentTask ? 1 : 0)} task(s) ahead`,
          ),
        );
        return;
      }

      const isFactory = typeof messages === "function";

      const task: GenerationTask = {
        id: params.taskId || api.v1.uuid(),
        messages: isFactory ? null : (messages as Message[]),
        messageFactory: isFactory ? (messages as MessageFactory) : undefined,
        params,
        callback,
        behaviour,
        signal,
        resolve,
        reject,
      };

      this.queue.push(task);
      this.updateState({
        // A fast-rejection task is only ever enqueued when the engine is idle,
        // so it goes straight to `generating` below — never advertise `queued`.
        status:
          this._state.status === "idle" && !params.fastRejection
            ? "queued"
            : this._state.status,
        queueLength: this.queue.length + (this.currentTask ? 1 : 0),
      });

      this.processQueue();
    });
  }

  public getTaskStatus(taskId: string): "queued" | "processing" | "not_found" {
    if (this.currentTask && this.currentTask.id === taskId) {
      return "processing";
    }
    if (this.queue.some((t) => t.id === taskId)) {
      return "queued";
    }
    return "not_found";
  }

  public cancelQueued(taskId: string): boolean {
    const index = this.queue.findIndex((t) => t.id === taskId);
    if (index === -1) return true;

    const [task] = this.queue.splice(index, 1);
    if (task.signal) {
      task.signal.cancel();
    }
    task.reject("Cancelled");
    this.updateState({
      queueLength: this.queue.length + (this.currentTask ? 1 : 0),
    });
    return true;
  }

  public cancelAll() {
    // 1. Reject and clear queued tasks
    const abandoned = this.queue.splice(0);
    for (const task of abandoned) {
      task.signal?.cancel();
      task.reject("Cancelled");
    }

    // 2. Cancel current task if running
    if (this.currentTask && this.currentTask.signal) {
      this.currentTask.signal.cancel();
    }

    // 3. Update state immediately (reactive UI will update)
    // Note: If a task was running, it will reject with "Cancelled" and set status to failed/idle in processQueue loop.
    // But if we just cleared queue and no task was running (e.g. queued state but not picked up?),
    // we should ensure status reflects it.

    // If we are just queued (idle/queued status), we force idle.
    if (!this.currentTask) {
      this.updateState({ status: "idle", queueLength: 0 });
    } else {
      // If task is running, the signal cancellation will trigger the rejection flow which updates state.
      // But we update queue length now.
      this.updateState({ queueLength: 0 }); // Current + 0
    }
  }

  public userInteraction() {
    if (this._state.status === "waiting_for_user") {
      this.updateState({ status: "waiting_for_budget" });
    }
  }

  // --- Internal Logic ---

  private updateState(partial: Partial<GenerationState>) {
    this._state = { ...this._state, ...partial };
    const snapshot = { ...this._state };
    this.listeners.forEach((l) => {
      try {
        l(snapshot);
      } catch (e) {
        api.v1.log("GenX Listener Error:", e);
      }
    });
    this.hooks?.onStateChange?.(snapshot);
  }

  private async trimToContextBudget(
    messages: Message[],
    params: GenerationParams,
    pinning: ContextPinning,
  ): Promise<Message[]> {
    const model = params.model;
    const maxContext = await api.v1.maxTokens(model);
    const rolloverBudget = await api.v1.rolloverTokens(model);
    const outputTokens = params.max_tokens || 1024;

    const headMsgs = messages.slice(0, pinning.head);
    const tailMsgs = messages.slice(messages.length - pinning.tail);
    const middleMsgs = messages.slice(pinning.head, messages.length - pinning.tail);

    if (middleMsgs.length === 0) return messages;

    // Count fixed token costs
    let fixedTokens = 0;
    for (const msg of [...headMsgs, ...tailMsgs]) {
      const encoded = await api.v1.tokenizer.encode(msg.content || "", model);
      fixedTokens += encoded.length;
    }

    const middleBudget = maxContext - fixedTokens - outputTokens;

    if (middleBudget <= 0) {
      api.v1.log(
        `[GenX] Context budget exhausted — dropping all middle content ` +
        `(fixed=${fixedTokens}, output=${outputTokens}, max=${maxContext})`,
      );
      return [...headMsgs, ...tailMsgs];
    }

    const helper = api.v1.createRolloverHelper<
      RolloverHelperContentObject & { role: string }
    >({
      maxTokens: middleBudget,
      rolloverTokens: rolloverBudget,
      model,
    });

    for (const msg of middleMsgs) {
      await helper.add({ content: msg.content || "", role: msg.role });
    }

    const surviving = helper.read();

    if (surviving.length < middleMsgs.length) {
      api.v1.log(
        `[GenX] Trimmed ${middleMsgs.length - surviving.length}/${middleMsgs.length} middle messages ` +
        `(budget=${middleBudget}, used=${helper.totalTokens()})`,
      );
    }

    const trimmedMiddle: Message[] = surviving.map((item) => ({
      role: item.role as Message["role"],
      content: item.content,
    }));

    return [...headMsgs, ...trimmedMiddle, ...tailMsgs];
  }

  private async processQueue() {
    if (this.currentTask) return; // Already processing
    if (this.queue.length === 0) {
      this.updateState({ status: "idle", queueLength: 0 });
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    this.currentTask = task;
    this.updateState({
      status: "generating",
      queueLength: this.queue.length + 1,
      error: undefined,
    });
    this.hooks?.onTaskStarted?.(task.id);

    try {
      await this.executeTask(task);
    } catch (e: any) {
      // Task failed (and retries exhausted or fatal)
      // The task.reject() has already been called in executeTask if needed,
      // or we do it here if it wasn't caught.
    } finally {
      this.currentTask = null;
      // Process next
      this.processQueue();
    }
  }

  private async executeTask(task: GenerationTask): Promise<void> {
    let { messages, params } = task;
    const { callback, behaviour, signal, resolve, reject } = task;

    // JIT: Resolve factory at execution time (when job is picked off queue)
    if (!messages && task.messageFactory) {
      try {
        const resolved = await task.messageFactory();
        messages = resolved.messages;
        if (resolved.params) {
          params = { ...params, ...resolved.params };
        }
        if (resolved.contextPinning) {
          task.contextPinning = resolved.contextPinning;
        }
      } catch (e: any) {
        this.updateState({ status: "failed", error: e.message || String(e) });
        reject(e);
        return;
      }
    }

    if (!messages) {
      const err = "No messages provided for generation";
      this.updateState({ status: "failed", error: err });
      reject(err);
      return;
    }

    // Context budgeting: trim content to fit tier's token limit
    const pinning = task.contextPinning ?? { head: 0, tail: 0 };
    messages = await this.trimToContextBudget(messages, params, pinning);

    this.hooks?.beforeGenerate?.(task.id, messages);

    const { maxRetries, taskId, fastRejection, ...apiParams } = params;
    // Fast-rejection callers run their own retry loop — never sleep on their behalf.
    const retryLimit = maxRetries ?? (fastRejection ? 0 : 5);
    let attempts = 0;

    while (true) {
      if (signal?.cancelled) {
        reject("Cancelled");
        return;
      }

      try {
        const requestedTokens = apiParams.max_tokens || 1024;

        // Budget Check (throws immediately when fastRejection is set)
        await this.ensureBudget(messages, params, requestedTokens, signal, fastRejection);

        if (signal?.cancelled) {
          reject("Cancelled");
          return;
        }

        this.updateState({ status: "generating" });

        const result = await api.v1.generate(
          messages,
          apiParams,
          callback,
          behaviour,
          signal,
        );

        resolve(result);
        this.updateState({ status: "completed" });
        return;
      } catch (e: any) {
        if (signal?.cancelled) {
          reject("Cancelled");
          return;
        }

        if (isFastRejection(e)) {
          // Don't surface a `failed` status — the background caller owns this
          // outcome and the UI should stay unaware of it.
          reject(e);
          return;
        }

        if (this.isTransientError(e)) {
          attempts++;
          if (attempts > retryLimit) {
            const err = `Transient error retries exhausted: ${e.message}`;
            if (fastRejection) {
              reject(e);
            } else {
              this.updateState({ status: "failed", error: err });
              reject(err);
            }
            return;
          }

          const delay = Math.pow(2, attempts) * 1000;
          api.v1.log(
            `Transient error: ${e.message}. Retrying in ${delay}ms...`,
          );
          await api.v1.timers.sleep(delay);
        } else {
          this.updateState({ status: "failed", error: e.message || String(e) });
          reject(e);
          return;
        }
      }
    }
  }

  // --- Budget Management ---

  private initBudgetListener() {
    // Listen for manual "Generate" clicks from user to unblock waiting
    api.v1.hooks.register("onGenerationRequested", (params) => {
      if (!params.scriptInitiated) {
        this.userInteraction();
      }
    });
  }

  private async ensureBudget(
    messages: Message[],
    params: GenerationParams,
    requestedOutput: number,
    signal?: CancellationSignal,
    fastRejection?: boolean,
  ): Promise<void> {
    const availableOutput = api.v1.script.getAllowedOutput();
    const availableInput = api.v1.script.getAllowedInput();

    // Compute input token count from messages
    let requestedInput = 0;
    for (const msg of messages) {
      const encoded = await api.v1.tokenizer.encode(msg.content || "", params.model);
      requestedInput += encoded.length;
    }

    const outputBlocking = availableOutput < requestedOutput;
    const inputBlocking = availableInput < requestedInput;

    if (!outputBlocking && !inputBlocking) return;

    const outputWait = outputBlocking ? api.v1.script.getTimeUntilAllowedOutput(requestedOutput) : 0;
    const inputWait = inputBlocking ? api.v1.script.getTimeUntilAllowedInput(requestedInput) : 0;

    if (fastRejection) {
      // Bail out before any waiting or state broadcast, so an opportunistic
      // background pass never makes the UI ask the user to click Generate.
      throw new FastRejectionError(
        "budget",
        `Insufficient budget: output=${availableOutput}/${requestedOutput}, ` +
        `input=${availableInput}/${requestedInput}`,
        Math.max(outputWait, inputWait),
      );
    }

    api.v1.log(
      `Waiting for budget: output=${availableOutput}/${requestedOutput} (wait=${outputWait}ms), ` +
      `input=${availableInput}/${requestedInput} (wait=${inputWait}ms)`,
    );

    this.updateState({
      status: "waiting_for_user",
      budgetWaitEndTime: Date.now() + Math.max(outputWait, inputWait),
    });

    // Wait for the longer budget first — the shorter one will have resolved by then
    if (outputWait >= inputWait) {
      if (outputBlocking) await api.v1.script.waitForAllowedOutput(requestedOutput);
      if (signal?.cancelled) return;
      if (inputBlocking) await api.v1.script.waitForAllowedInput(requestedInput);
    } else {
      if (inputBlocking) await api.v1.script.waitForAllowedInput(requestedInput);
      if (signal?.cancelled) return;
      if (outputBlocking) await api.v1.script.waitForAllowedOutput(requestedOutput);
    }
    if (signal?.cancelled) return;

    this.updateState({ status: "generating" });
  }

  private isTransientError(e: any): boolean {
    const msg = (e?.message || String(e)).toLowerCase();
    return (
      msg.includes("aborted") ||
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("in progress")
    );
  }
}
