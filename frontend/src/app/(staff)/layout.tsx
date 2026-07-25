import { redirect } from "next/navigation";
import { StaffSidebar } from "@/components/staff/StaffSidebar";
import { getSessionUser } from "@/lib/session";

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // Staff run this surface; admin is admitted as a superset for support. Everyone else out.
  const role = (user as { role?: string }).role;
  if (role !== "staff" && role !== "admin") redirect("/dashboard");

  return (
    <div className="flex min-h-screen flex-col bg-canvas lg:flex-row">
      <StaffSidebar />
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
