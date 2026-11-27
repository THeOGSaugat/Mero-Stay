import Link from "next/link";
import { CATEGORIES, categoryHref } from "@/lib/categories";
import { HeaderNav } from "./header-nav";
import { LogoMark } from "./ui/icons";

const categoryLink =
  "rounded-control px-3 py-2 text-sm font-medium text-white/90 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The site header (Phase 13 design): forest-green bar, logo, the four customer categories
 * (never Flights) and the account links. On phones the categories become a scrollable second row
 * so every account link stays visible.
 */
export function SiteHeader() {
  return (
    <header className="bg-primary text-white">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-control font-display text-2xl font-bold tracking-tight text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          <LogoMark className="h-7 w-10 text-white" />
          MeroStay
        </Link>
        <nav aria-label="Categories" className="hidden flex-1 items-center gap-1 md:flex">
          {CATEGORIES.map((category) => (
            <Link key={category.id} href={categoryHref(category.id)} className={categoryLink}>
              {category.label}
            </Link>
          ))}
        </nav>
        <HeaderNav />
      </div>
      <nav
        aria-label="Categories (mobile)"
        className="flex gap-1 overflow-x-auto border-t border-white/10 px-2 py-1 md:hidden"
      >
        {CATEGORIES.map((category) => (
          <Link
            key={category.id}
            href={categoryHref(category.id)}
            className={`${categoryLink} shrink-0`}
          >
            {category.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
