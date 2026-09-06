// App-layer permission helpers. These mirror Supabase RLS — they exist for
// UX (hiding buttons) only. Every mutation is re-checked by RLS + server
// routes, so a modified client gains nothing.

export type Role = "admin" | "member";

export const canUpload = (role: Role) => role === "admin" || role === "member";
// Member uploads land in `pending`; only admin approves into shared library.
export const canApproveDocuments = (role: Role) => role === "admin";
export const canDeleteDocuments = (role: Role) => role === "admin";
export const canManageMembers = (role: Role) => role === "admin";
export const canManageLimit = (role: Role) => role === "admin";
export const canManageSettings = (role: Role) => role === "admin";

export const canReadLibrary = () => true; // any active member
export const canResearch = () => true;
export const canCreateChat = () => true;
export const canCreateProject = () => true;

// Chat mutation rule: only the owner may continue their own chat.
// Others must "Import to my chats" (copies into a new owner_id thread).
export const canContinueChat = (
  currentUserId: string,
  chatOwnerId: string,
) => currentUserId === chatOwnerId;
