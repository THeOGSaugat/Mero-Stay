import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-slate-200">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md text-lg font-bold tracking-tight text-brand-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600"
        >
          <svg aria-hidden="true" viewBox="0 0 32 32" className="size-7">
            <rect width="32" height="32" rx="7" className="fill-brand-700" />
            <path d="M6 23 13 10l4 7 3-4 6 10z" fill="#fff" />
          </svg>
          MeroStay
        </Link>
      </div>
    </header>
  );
}
