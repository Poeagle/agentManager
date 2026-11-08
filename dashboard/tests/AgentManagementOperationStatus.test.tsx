import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperationStatus } from "../src/components/AgentManagementPanel";

describe("Agent management operation status", () => {
  it("uses completed wording after a busy operation succeeds", () => {
    const { rerender } = render(
      <OperationStatus
        busy
        message="正在写入模型目录…"
        successMessage="模型目录已写入"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在写入模型目录…");

    rerender(
      <OperationStatus
        success
        message="正在写入模型目录…"
        successMessage="模型目录已写入"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("模型目录已写入");
    expect(screen.getByRole("status")).not.toHaveTextContent("正在写入");
  });
});
