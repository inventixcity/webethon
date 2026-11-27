"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { Profile } from "@/features/account/types";
import { getTeam, listInvites, listMembers, listTeams } from "./client";
import type { Invite, Member, Team } from "./types";

/** The teams the signed-in person belongs to. */
export function useTeams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setTeams(await listTeams());
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { teams, loading, error, reload };
}

export function useTeam(teamId: string) {
  const [team, setTeam] = useState<Team>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setTeam(await getTeam(teamId));
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { team, loading, error, reload };
}

/** Members, one page at a time. Later pages are appended. */
export function useMembers(teamId: string) {
  const [members, setMembers] = useState<Member[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const page = await listMembers(teamId);
      setMembers(page.data);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listMembers(teamId, nextCursor);
      setMembers((current) => [...current, ...page.data]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }, [teamId, nextCursor]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { members, hasMore: nextCursor !== null, loading, loadingMore, error, reload, loadMore };
}

/** Pending invites, newest first. */
export function useInvites(teamId: string) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setInvites(await listInvites(teamId));
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { invites, loading, error, reload };
}

/** The signed-in person's id. Leaving a team needs it, because the API removes a member by id. */
export function useCurrentUserId() {
  const [userId, setUserId] = useState<string>();

  useEffect(() => {
    let active = true;
    api<Profile>("/me")
      .then((profile) => {
        if (active) setUserId(profile.id);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return userId;
}
