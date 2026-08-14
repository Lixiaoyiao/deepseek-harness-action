export type RepositoryRole = "admin" | "owner" | "viewer";

export function canDeleteRepository(role: RepositoryRole): boolean {
  return role === "admin" || role === "owner";
}
