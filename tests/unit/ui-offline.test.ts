import { describe, expect, it, vi } from "vitest";
import { startOffline, type ContainerLike, type RegistrationLike } from "../../src/ui/offline";

function fake(opts: { waiting?: boolean; controller?: boolean; fail?: boolean } = {}) {
  const posted: unknown[] = [];
  const listeners: (() => void)[] = [];
  const reg: RegistrationLike = { waiting: opts.waiting ? { postMessage: (m) => posted.push(m) } : null };
  const sw: ContainerLike & { change(): void } = {
    controller: opts.controller ? {} : null,
    register: vi.fn(async () => { if (opts.fail) throw new Error("no"); return reg; }),
    addEventListener: (_t, fn) => listeners.push(fn),
    change: () => listeners.forEach((f) => f()),
  };
  return { sw, posted };
}

const options = (idle = true) => ({ base: "/nakwad/", idle: () => idle, reload: vi.fn(), reloadLater: vi.fn() });

describe("offline and updates", () => {
  it("does nothing where service workers are missing", async () => {
    expect(await startOffline(undefined, options())).toBe("unsupported");
  });

  it("registers the worker for the app's folder", async () => {
    const { sw } = fake();
    expect(await startOffline(sw, options())).toBe("ready");
    expect(sw.register).toHaveBeenCalledWith("/nakwad/sw.js", { scope: "/nakwad/" });
  });

  it("a failed registration is reported, not thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await startOffline(fake({ fail: true }).sw, options())).toBe("failed");
    err.mockRestore();
  });

  it("a new version waiting from last time takes over on open, then the page reloads once", async () => {
    const { sw, posted } = fake({ waiting: true, controller: true });
    const o = options();
    expect(await startOffline(sw, o)).toBe("updating");
    expect(posted).toEqual([{ type: "SKIP_WAITING" }]);
    expect(o.reload).not.toHaveBeenCalled();
    sw.change();
    sw.change();
    expect(o.reload).toHaveBeenCalledTimes(1);
  });

  it("never switches while a work is open; a switch that lands after one opened reloads later", async () => {
    const busy = fake({ waiting: true, controller: true });
    expect(await startOffline(busy.sw, options(false))).toBe("ready");
    expect(busy.posted).toEqual([]);

    const { sw } = fake({ waiting: true, controller: true });
    let idle = true;
    const o = { ...options(), idle: () => idle };
    await startOffline(sw, o);
    idle = false; // the person opened a work before the new version took over
    sw.change();
    expect(o.reload).not.toHaveBeenCalled();
    expect(o.reloadLater).toHaveBeenCalledTimes(1);
  });

  it("the very first install switches nothing", async () => {
    const { sw, posted } = fake({ waiting: true, controller: false });
    expect(await startOffline(sw, options())).toBe("ready");
    expect(posted).toEqual([]);
  });
});
