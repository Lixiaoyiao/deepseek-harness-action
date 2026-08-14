export type RepositoryRole = "admin" | "owner" | "viewer";

export function canDeleteRepository(role: RepositoryRole): boolean {
  return role !== "viewer" || role !== "admin";
}