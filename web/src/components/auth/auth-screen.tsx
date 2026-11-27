import dynamic from "next/dynamic";
import type { ComponentType, ReactNode } from "react";
import type { AuthScreenId, AuthSetId } from "@/config/kit";
import { Art } from "@/components/ui/art";
import { DriftField } from "@/components/ui/empty-state";

type ScreenProps = { email?: string; next?: string; side?: ReactNode; demo?: ReactNode };

// Each screen loads on its own, so a page never carries the code for the other sets.
const screens: Record<AuthSetId, Record<AuthScreenId, ComponentType<ScreenProps>>> = {
  1: {
    login: dynamic(() => import("./set-1/login")),
    signup: dynamic(() => import("./set-1/signup")),
    "forgot-password": dynamic(() => import("./set-1/forgot")),
    verify: dynamic(() => import("./set-1/verify")),
    "reset-password": dynamic(() => import("./set-1/reset")),
  },
  2: {
    login: dynamic(() => import("./set-2/login")),
    signup: dynamic(() => import("./set-2/signup")),
    "forgot-password": dynamic(() => import("./set-2/forgot")),
    verify: dynamic(() => import("./set-2/verify")),
    "reset-password": dynamic(() => import("./set-2/reset")),
  },
  3: {
    login: dynamic(() => import("./set-3/login")),
    signup: dynamic(() => import("./set-3/signup")),
    "forgot-password": dynamic(() => import("./set-3/forgot")),
    verify: dynamic(() => import("./set-3/verify")),
    "reset-password": dynamic(() => import("./set-3/reset")),
  },
  4: {
    login: dynamic(() => import("./set-4/login")),
    signup: dynamic(() => import("./set-4/signup")),
    "forgot-password": dynamic(() => import("./set-4/forgot")),
    verify: dynamic(() => import("./set-4/verify")),
    "reset-password": dynamic(() => import("./set-4/reset")),
  },
  5: {
    login: dynamic(() => import("./set-5/login")),
    signup: dynamic(() => import("./set-5/signup")),
    "forgot-password": dynamic(() => import("./set-5/forgot")),
    verify: dynamic(() => import("./set-5/verify")),
    "reset-password": dynamic(() => import("./set-5/reset")),
  },
  6: {
    login: dynamic(() => import("./set-6/login")),
    signup: dynamic(() => import("./set-6/signup")),
    "forgot-password": dynamic(() => import("./set-6/forgot")),
    verify: dynamic(() => import("./set-6/verify")),
    "reset-password": dynamic(() => import("./set-6/reset")),
  },
};

export function AuthScreen({ set, screen, ...props }: { set: AuthSetId; screen: AuthScreenId } & ScreenProps) {
  const Screen = screens[set][screen];
  // The editorial side panel for the set 1 sign-in. It fills its column from md up, and falls back to the ASCII field.
  const side =
    set === 1 && screen === "login" ? (
      <Art
        name="login-side"
        alt=""
        sizes="(min-width: 768px) 30vw, 0px"
        // Aim at the pencil and eraser on the front desk, so they stay in frame at any panel height.
        position="object-[92%_78%]"
        className="absolute inset-0"
        fallback={<DriftField className="size-full" />}
      />
    ) : undefined;
  return <Screen side={side} {...props} />;
}
