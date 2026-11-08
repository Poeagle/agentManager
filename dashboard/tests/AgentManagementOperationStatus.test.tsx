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

  it("shows the current Engine operation percentage while busy", () => {
    render(
      <OperationStatus
        busy
        progress={75}
        message="等待 Engine socket 就绪"
      />,
    );

    expect(screen.getByText("等待 Engine socket 就绪")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "75",
    );
  });
});
