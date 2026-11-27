"use client";

import { Eraser, Pen, Trash2, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const WIDTH = 960;
const HEIGHT = 640;
const UNDO_LIMIT = 12;
const PEN_WIDTH = 4;
const ERASER_WIDTH = 28;

type Tool = "pen" | "eraser";
type Color = "ink" | "vermilion";

/**
 * A sketch pad on a fixed-size canvas. Colours are read from the design tokens on the canvas itself, so
 * the pad follows the workspace theme. Keyboard users get the same tools as buttons; the drawing surface
 * itself is for pointer and touch input.
 */
export function SketchCanvas({
  initial,
  onChange,
}: {
  /** The stored PNG data URL, drawn once when the pad mounts. */
  initial: string | null;
  /** Called after each stroke, undo, or clear with a PNG data URL, or null when the pad is empty. */
  onChange: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const undoStack = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);
  const initialRef = useRef(initial);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<Color>("ink");
  const [undoCount, setUndoCount] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const source = initialRef.current;
    if (!canvas || !ctx || !source) return;
    const image = new Image();
    image.onload = () => ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = source;
  }, []);

  function context(): CanvasRenderingContext2D | null {
    return canvasRef.current?.getContext("2d") ?? null;
  }

  function tokenColor(token: "--ink" | "--vermilion"): string {
    const canvas = canvasRef.current;
    if (!canvas) return "#12110e";
    const value = getComputedStyle(canvas).getPropertyValue(token).trim();
    return value || "#12110e";
  }

  function pointOf(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) * canvas.width) / box.width,
      y: ((event.clientY - box.top) * canvas.height) / box.height,
    };
  }

  function pushUndo(ctx: CanvasRenderingContext2D) {
    undoStack.current.push(ctx.getImageData(0, 0, WIDTH, HEIGHT));
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  }

  function paint(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = ERASER_WIDTH;
      ctx.strokeStyle = "#000";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = PEN_WIDTH;
      ctx.strokeStyle = tokenColor(color === "ink" ? "--ink" : "--vermilion");
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  function emit() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange(isBlank(canvas) ? null : canvas.toDataURL("image/png"));
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const ctx = context();
    if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pushUndo(ctx);
    const point = pointOf(event);
    last.current = point;
    paint(ctx, point, point);
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const ctx = context();
    const previous = last.current;
    if (!ctx || !previous) return;
    const point = pointOf(event);
    paint(ctx, previous, point);
    last.current = point;
  }

  function onPointerEnd() {
    if (last.current === null) return;
    last.current = null;
    emit();
  }

  function undo() {
    const ctx = context();
    const previous = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (!ctx || !previous) return;
    ctx.putImageData(previous, 0, 0);
    emit();
  }

  function clear() {
    const ctx = context();
    if (!ctx) return;
    pushUndo(ctx);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    onChange(null);
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Sketch tools">
        <ToolButton active={tool === "pen"} label="Pen" onClick={() => setTool("pen")}>
          <Pen className="size-4" aria-hidden />
        </ToolButton>
        <ToolButton active={tool === "eraser"} label="Eraser" onClick={() => setTool("eraser")}>
          <Eraser className="size-4" aria-hidden />
        </ToolButton>
        <span className="mx-1 h-6 w-px bg-(--ws-line)" aria-hidden="true" />
        <ToolButton active={color === "ink"} label="Ink colour" onClick={() => setColor("ink")}>
          <span aria-hidden="true" className="size-4 bg-ink" />
        </ToolButton>
        <ToolButton active={color === "vermilion"} label="Vermilion colour" onClick={() => setColor("vermilion")}>
          <span aria-hidden="true" className="size-4 bg-vermilion" />
        </ToolButton>
        <span className="mx-1 h-6 w-px bg-(--ws-line)" aria-hidden="true" />
        <ToolButton label="Undo" disabled={undoCount === 0} onClick={undo}>
          <Undo2 className="size-4" aria-hidden />
        </ToolButton>
        <ToolButton label="Clear sketch" onClick={clear}>
          <Trash2 className="size-4" aria-hidden />
        </ToolButton>
      </div>
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label="Sketch pad. Drawing is for pointer or touch. Use the Text tab for keyboard entry."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={onPointerEnd}
        className="block aspect-[3/2] w-full touch-none border border-(--ws-line) bg-paper-raised text-ink cursor-crosshair"
      />
    </div>
  );
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={label}
      className={cn(
        "grid size-10 cursor-pointer place-items-center border border-ink transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion disabled:cursor-not-allowed disabled:border-(--ws-line) disabled:text-ink-muted",
        active ? "bg-ink text-paper" : "text-ink hover:bg-paper-sunk",
      )}
    >
      {children}
    </button>
  );
}

/** A blank canvas has no alpha at all, so this reads the alpha channel with a cheap sample. */
function isBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return true;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 0) return false;
  }
  return true;
}
