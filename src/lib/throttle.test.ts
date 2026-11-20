import { describe, expect, it, vi } from "vitest";
import { throttle } from "./throttle";

describe("throttle", () => {
  it("executa no início e no fim da janela, com o último argumento", () => {
    vi.useFakeTimers();
    const f = vi.fn();
    const t = throttle(f, 60);
    t(1);
    t(2);
    t(3);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenLastCalledWith(1);
    vi.advanceTimersByTime(60);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenLastCalledWith(3);
    vi.useRealTimers();
  });
});
