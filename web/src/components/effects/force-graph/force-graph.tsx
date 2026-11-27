"use client";

import { useEffect, useMemo, useRef } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { cn } from "@/lib/utils";
import { createGraphScene, type GraphLink, type GraphNode } from "./scene";

export type ForceGraphProps = {
  nodes: readonly GraphNode[];
  links: readonly GraphLink[];
  label: string;
  className?: string;
};

/** A living network of square nodes. Grab one and the rest follow; hover to trace what it connects to. */
export function ForceGraph({ nodes, links, label, className }: ForceGraphProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useMemo(() => createGraphScene(nodes, links), [nodes, links]);

  useEffect(() => {
    scene.onHover = (over) => {
      if (host.current) host.current.style.cursor = over ? "grab" : "";
    };
  }, [scene]);

  const hubs = useMemo(() => {
    const neighbours = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
    const nameOf = new Map(nodes.map((node) => [node.id, node.label]));
    for (const [from, to] of links) {
      neighbours.get(from)?.push(nameOf.get(to) ?? to);
      neighbours.get(to)?.push(nameOf.get(from) ?? from);
    }
    return nodes
      .map((node) => ({ ...node, linked: neighbours.get(node.id) ?? [] }))
      .sort((a, b) => b.linked.length - a.linked.length)
      .slice(0, 7);
  }, [nodes, links]);

  const local = (event: React.PointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top] as const;
  };

  return (
    <div className={cn("w-full max-w-5xl", className)}>
      <div
        ref={host}
        role="img"
        aria-label={label}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          scene.press(...local(event));
        }}
        onPointerUp={() => scene.release()}
        onPointerCancel={() => scene.release()}
        className="h-[56dvh] min-h-80 w-full touch-pan-y bg-paper-raised select-none"
      >
        <LiveCanvas scene={scene} />
      </div>
      <ul className="mt-3 flex flex-wrap gap-1">
        {hubs.map((hub) => (
          <li key={hub.id}>
            <button
              type="button"
              aria-label={`${hub.label}, connected to ${hub.linked.join(", ")}`}
              onPointerEnter={() => scene.focus(hub.id)}
              onPointerLeave={() => scene.focus(null)}
              onFocus={() => scene.focus(hub.id)}
              onBlur={() => scene.focus(null)}
              className="h-9 cursor-pointer border border-rule px-3 text-xs hover:border-ink focus:border-ink"
            >
              {hub.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
