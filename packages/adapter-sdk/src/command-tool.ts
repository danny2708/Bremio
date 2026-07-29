import { ProcessSupervisor } from "./process-supervisor";

export interface CommandToolOptions {
  runId: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
  timedOut: boolean;
  signal: string | null;
  duration: number;
}

export class CommandTool {
  constructor(private readonly supervisor: ProcessSupervisor) {}

  async execute(
    command: string,
    args: string[],
    options: CommandToolOptions,
  ): Promise<CommandResult> {
    const started = Date.now();
    const { runId, cwd, env: extraEnv, signal: externalSignal, timeout } = options;

    const abortController = new AbortController();
    const signalsToCombine: AbortSignal[] = [abortController.signal];
    if (externalSignal) signalsToCombine.push(externalSignal);

    const combinedSignal = AbortSignal.any(signalsToCombine);

    let timedOut = false;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeout !== undefined && timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error(`timed out after ${timeout}ms`));
      }, timeout);
    }

    const child = this.supervisor.spawn(runId, command, args, {
      cwd,
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
      signal: combinedSignal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

    let exitCode: number | null = null;
    let signalCode: string | null = null;

    try {
      [exitCode, signalCode] = await new Promise<[number | null, string | null]>((resolve) => {
        child.on("close", (code, sig) => resolve([code, sig]));
        child.on("error", () => resolve([null, null]));
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const duration = Date.now() - started;

    return {
      stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      exitCode: exitCode ?? -1,
      killed: child.killed || combinedSignal.aborted,
      timedOut,
      signal: signalCode,
      duration,
    };
  }
}
