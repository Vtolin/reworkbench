"use client";

import { useState } from "react";
import { useSession } from "@/contexts/SessionContext";
import { createClient } from "@/lib/supabase/client";
import {
  MIN_PASSWORD_LENGTH,
  completePasswordUpdate,
  requestPasswordReset,
} from "@/lib/auth/passwordReset";
import {
  Panel,
  buttonClass,
  fieldClass,
  primaryButtonClass,
} from "@/components/ui/Panel";

/** Account password change & email reset trigger inside Settings. */
export function AccountSecurityCard() {
  const { user } = useSession();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busyUpdate, setBusyUpdate] = useState(false);
  const [busyEmail, setBusyEmail] = useState(false);
  const [status, setStatus] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  const handleDirectUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyUpdate(true);
    setStatus(null);
    try {
      const result = await completePasswordUpdate(
        createClient(),
        newPassword,
        confirmPassword,
      );
      if (!result.ok) {
        setStatus({ kind: "err", text: result.error });
        return;
      }
      setNewPassword("");
      setConfirmPassword("");
      setStatus({ kind: "ok", text: "Password updated." });
    } finally {
      setBusyUpdate(false);
    }
  };

  const handleSendResetEmail = async () => {
    if (!user?.email) return;
    setBusyEmail(true);
    setStatus(null);
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const result = await requestPasswordReset(
        createClient(),
        user.email,
        origin,
      );
      if (!result.ok) {
        setStatus({ kind: "err", text: result.error });
        return;
      }
      setStatus({
        kind: "ok",
        text: `Password reset link sent to ${user.email}.`,
      });
    } finally {
      setBusyEmail(false);
    }
  };

  return (
    <Panel
      title="Account & password"
      description={
        user?.email ? (
          <>
            Signed in as <span className="text-white">{user.email}</span>. Change your password directly or send a reset link to your email.
          </>
        ) : (
          "Manage your account password."
        )
      }
    >
      <form onSubmit={handleDirectUpdate} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-[#ececec]">
          New password
          <input
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={fieldClass}
            required
          />
        </label>
        <label className="block text-xs font-medium text-[#ececec]">
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            placeholder="Repeat new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={fieldClass}
            required
          />
        </label>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={busyUpdate}
            className={primaryButtonClass}
          >
            {busyUpdate ? "Updating…" : "Update password"}
          </button>
          {user?.email ? (
            <button
              type="button"
              disabled={busyEmail}
              onClick={handleSendResetEmail}
              className={buttonClass}
            >
              {busyEmail ? "Sending email…" : "Send reset link to email"}
            </button>
          ) : null}
        </div>
      </form>
      {status ? (
        <p
          className={`mt-3 text-xs ${
            status.kind === "ok" ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {status.text}
        </p>
      ) : null}
    </Panel>
  );
}
