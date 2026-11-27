import type { LiveFrame, LiveScene } from "@/components/canvas/live-canvas";

export type GraphNode = { id: string; label: string };
export type GraphLink = readonly [from: string, to: string];

type Body = GraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  seed: number;
  linked: Set<Body>;
};

export type GraphScene = LiveScene & {
  /** Picks up the node under this point, if there is one. */
  press(x: number, y: number): void;
  release(): void;
  /** Lights up a node and its neighbours, as if the pointer were on it. */
  focus(id: string | null): void;
  /** Called with whether the pointer is over a node, for the cursor. */
  onHover?: (over: boolean) => void;
};

const REST = 84; // how long a link wants to be
const REACH = 22; // how close counts as on a node
const SETTLE_STEPS = 500;

export function createGraphScene(nodes: readonly GraphNode[], links: readonly GraphLink[]): GraphScene {
  const bodies: Body[] = nodes.map((node, index) => {
    const angle = index * 2.399963;
    const radius = 22 * Math.sqrt(index + 1);
    return {
      ...node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      degree: 0,
      seed: index * 1.7,
      linked: new Set<Body>(),
    };
  });
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const edges: [Body, Body][] = [];
  for (const [from, to] of links) {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) continue;
    edges.push([a, b]);
    a.degree += 1;
    b.degree += 1;
    a.linked.add(b);
    b.linked.add(a);
  }

  let width = 0;
  let height = 0;
  let cursorX = -9999;
  let cursorY = -9999;
  let hovered: Body | null = null;
  let held: Body | null = null;
  let chosen: Body | null = null;
  let settled = false;

  const zoom = () => Math.max(0.55, Math.min(1.25, Math.min(width, height) / 520));
  const sizeOf = (body: Body) => 6 + body.degree * 1.7;

  function nearest(x: number, y: number) {
    let best: Body | null = null;
    let closest = REACH;
    for (const body of bodies) {
      const away = Math.hypot(body.x + width / 2 - x, body.y + height / 2 - y);
      if (away < closest) {
        closest = away;
        best = body;
      }
    }
    return best;
  }

  function tick(step: number, time: number) {
    const scale = zoom();
    const length = REST * scale;
    const charge = 5200 * scale * scale;

    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i] as Body;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j] as Body;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(dx * dx + dy * dy, 100);
        const push = (charge / distance / Math.sqrt(distance)) * step;
        a.vx -= dx * push;
        a.vy -= dy * push;
        b.vx += dx * push;
        b.vy += dy * push;
      }
    }

    for (const [a, b] of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const pull = ((distance - length) / distance) * 0.035 * step;
      a.vx += dx * pull;
      a.vy += dy * pull;
      b.vx -= dx * pull;
      b.vy -= dy * pull;
    }

    const room = { x: width / 2 - 28, y: height / 2 - 28 };
    const damping = 0.84 ** step;
    for (const body of bodies) {
      if (body === held) {
        body.x = cursorX - width / 2;
        body.y = cursorY - height / 2;
        body.vx = 0;
        body.vy = 0;
        continue;
      }
      // A slow, private wander, so the graph never quite comes to rest.
      body.vx += (Math.sin(time * 0.6 + body.seed) * 0.05 - body.x * 0.0035) * step;
      body.vy += (Math.cos(time * 0.5 + body.seed * 1.3) * 0.05 - body.y * 0.0045) * step;

      if (!held) {
        const dx = body.x + width / 2 - cursorX;
        const dy = body.y + height / 2 - cursorY;
        const distance = Math.hypot(dx, dy);
        if (distance > 24 && distance < 120) {
          const shove = ((1 - distance / 120) * 0.5 * step) / distance;
          body.vx += dx * shove;
          body.vy += dy * shove;
        }
      }

      body.vx *= damping;
      body.vy *= damping;
      body.x = Math.max(-room.x, Math.min(room.x, body.x + body.vx * step));
      body.y = Math.max(-room.y, Math.min(room.y, body.y + body.vy * step));
    }
  }

  function draw(context: CanvasRenderingContext2D, frame: LiveFrame) {
    width = frame.width;
    height = frame.height;
    const { colors, time, dt, reduced } = frame;

    if (reduced && !settled) {
      for (let index = 0; index < SETTLE_STEPS; index++) tick(1, index * 0.016);
      settled = true;
    }
    if (!reduced) tick(Math.min(dt * 60, 2), time);

    const lit = held ?? hovered ?? chosen;
    const centerX = width / 2;
    const centerY = height / 2;

    context.lineWidth = 1;
    for (const [a, b] of edges) {
      const on = lit !== null && (a === lit || b === lit);
      context.globalAlpha = lit && !on ? 0.25 : 1;
      context.strokeStyle = on ? colors.accent : colors.rule;
      context.lineWidth = on ? 1.5 : 1;
      context.beginPath();
      context.moveTo(a.x + centerX, a.y + centerY);
      context.lineTo(b.x + centerX, b.y + centerY);
      context.stroke();
    }

    for (const body of bodies) {
      const on = !lit || body === lit || lit.linked.has(body);
      const size = sizeOf(body);
      context.globalAlpha = on ? 1 : 0.28;
      context.fillStyle = body === lit ? colors.accent : colors.ink;
      context.fillRect(body.x + centerX - size / 2, body.y + centerY - size / 2, size, size);
    }

    context.textAlign = "center";
    context.textBaseline = "top";
    context.font = `500 12px ${frame.headingFont || "sans-serif"}`;
    for (const body of bodies) {
      const named = lit ? body === lit || lit.linked.has(body) : body.degree >= 4;
      if (!named) continue;
      const x = Math.max(44, Math.min(width - 44, body.x + centerX));
      const y = body.y + centerY + sizeOf(body) / 2 + 5;
      const wide = context.measureText(body.label).width + 8;
      context.globalAlpha = 1;
      context.fillStyle = colors.paper;
      context.fillRect(x - wide / 2, y - 1, wide, 16);
      context.fillStyle = colors.ink;
      context.fillText(body.label, x, y + 1);
    }
    context.globalAlpha = 1;
  }

  const scene: GraphScene = {
    draw,
    pointer(x, y) {
      cursorX = x;
      cursorY = y;
      if (held) {
        // Under reduced motion nothing else moves the node, so it follows here.
        held.x = x - width / 2;
        held.y = y - height / 2;
        scene.dirty = true;
        return;
      }
      const next = x >= 0 && y >= 0 && x <= width && y <= height ? nearest(x, y) : null;
      if (next !== hovered) {
        hovered = next;
        scene.dirty = true;
        scene.onHover?.(next !== null);
      }
    },
    press(x, y) {
      cursorX = x;
      cursorY = y;
      held = nearest(x, y);
      scene.dirty = true;
    },
    release() {
      held = null;
      scene.dirty = true;
    },
    focus(id) {
      chosen = id ? (byId.get(id) ?? null) : null;
      scene.dirty = true;
    },
  };

  return scene;
}
