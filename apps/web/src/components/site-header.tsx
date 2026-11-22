import Link from "next/link";
import { HeaderNav } from "./header-nav";

export function SiteHeader() {
  return (
    <header className="border-b border-mist bg-white">
      <div className="mx-auto flex min-h-16 w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md text-lg font-bold tracking-tight text-navy focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal"
        >
          <svg aria-hidden="true" viewBox="0 0 32 32" className="size-7">
            <rect width="32" height="32" rx="7" className="fill-navy" />
            <path d="M6 23 13 10l4 7 3-4 6 10z" className="fill-teal" />
          </svg>
          MeroStay
        </Link>
        <HeaderNav />
      </div>
    </header>
  );
}
