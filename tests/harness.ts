// In-memory doubles: a Job needs only an IPlugin, so a handler can be driven
// without a broker and without the platform.
import type { Msg } from "nats";
import { Job } from "@inflowenger/node-plugin-sdk";
import type { IPlugin } from "@inflowenger/node-plugin-sdk";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface Sent {
  subject: string;
  body: string;
  /** The last segment of the subject: the command the job sent. */
  command: string;
}

/** A plugin that records commands instead of publishing them, and answers scope reads. */
export class FakePlugin implements IPlugin {
  readonly sent: Sent[] = [];
  /** JSON path -> the value the runtime should answer with. */
  readonly scope = new Map<string, unknown>();

  async send(subject: string, data: Uint8Array): Promise<Msg | undefined> {
    const body = decoder.decode(data);
    this.sent.push({ subject, body, command: subject.split(".").pop() ?? "" });
    return undefined;
  }

  getPluginId(): string {
    return "TEST";
  }

  /**
   * Commands in order, named the way a plugin author thinks of them.
   *
   * A terminal call is not its own subject: `done` and the `doneWithError`
   * family both ride `progress` with `progress: 100`, which is exactly the
   * distinction the "one terminal call per path" rule is about — so the harness
   * reports that as `done` and an ordinary frame as `progress`.
   */
  commands(): string[] {
    return this.sent.map((s) => (s.command === "progress" && this.isTerminal(s) ? "done" : s.command));
  }

  private isTerminal(sent: Sent): boolean {
    try {
      return Number((JSON.parse(sent.body) as { progress?: unknown }).progress) >= 100;
    } catch {
      return false;
    }
  }

  /** The body of the first command with this name, parsed. */
  payload(command: string): Record<string, unknown> {
    return JSON.parse(this.raw(command)) as Record<string, unknown>;
  }

  /** The raw body of the first command with this name. */
  raw(command: string): string {
    const names = this.commands();
    const i = names.indexOf(command);
    if (i < 0) throw new Error(`no ${command} command was sent (saw: ${names.join(", ")})`);
    return this.sent[i]!.body;
  }
}

/**
 * A plugin that also answers context reads, standing in for the runtime's half
 * of `cmdGetScope` — enough to exercise `{{$.path}}` resolution and the
 * human-answer path.
 */
export class ScopedPlugin extends FakePlugin {
  override async send(subject: string, data: Uint8Array): Promise<Msg | undefined> {
    await super.send(subject, data);
    if (!subject.endsWith("context/path")) return undefined;
    const path = decoder.decode(data);
    if (!this.scope.has(path)) return { data: new Uint8Array(0) } as Msg;
    return { data: encode(this.scope.get(path)) } as Msg;
  }

  /** Stand in for the runtime's reply to a context-path read. */
  answerFor(path: string, value: unknown): void {
    this.scope.set(path, value);
  }
}

/** A Job over a fake plugin, carrying `body` as its request. */
export function fakeJob(
  plugin: IPlugin,
  body: Record<string, unknown>,
  registry: Record<string, unknown> = {},
  jobId = "11111111-2222-4333-8444-555555555555",
): Job {
  return new Job(plugin, "claude.agent.run", jobId, {
    data: encoder.encode(JSON.stringify({ _registry: registry, body })),
    plugin,
  });
}

export const encode = (v: unknown): Uint8Array => encoder.encode(JSON.stringify(v));
