import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-slate-500 sm:px-6">
        <span>© MeroStay · Stays across Nepal</span>
        <Link href="/partner/onboarding" className="font-medium text-navy hover:underline">
          List your business
        </Link>
      </div>
    </footer>
  );
}
