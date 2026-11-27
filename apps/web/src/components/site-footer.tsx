import Link from "next/link";
import { CATEGORIES, categoryHref } from "@/lib/categories";
import { LogoMark } from "./ui/icons";

const footerLink =
  "rounded-control text-sm text-white/80 hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Site footer (Phase 13 design): only links to pages that exist. */
export function SiteFooter() {
  return (
    <footer className="mt-12 bg-primary-dark text-white">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3 sm:px-6">
        <div>
          <p className="flex items-center gap-2 font-display text-xl font-bold">
            <LogoMark className="h-6 w-9 text-white" />
            MeroStay
          </p>
          <p className="mt-2 max-w-xs text-sm text-white/80">
            Stays, buses, guides and experiences across Nepal, booked as one trip.
          </p>
        </div>
        <nav aria-label="Explore">
          <h2 className="text-sm font-semibold tracking-wide text-accent uppercase">Explore</h2>
          <ul className="mt-3 space-y-2">
            {CATEGORIES.map((category) => (
              <li key={category.id}>
                <Link href={categoryHref(category.id)} className={footerLink}>
                  {category.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="For businesses">
          <h2 className="text-sm font-semibold tracking-wide text-accent uppercase">
            For businesses
          </h2>
          <ul className="mt-3 space-y-2">
            <li>
              <Link href="/partner/onboarding" className={footerLink}>
                List your business
              </Link>
            </li>
            <li>
              <Link href="/partner" className={footerLink}>
                Partner dashboard
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto w-full max-w-6xl px-4 py-4 text-xs text-white/70 sm:px-6">
          © MeroStay · Prices in Nepalese rupees · Times in Nepal time (NPT)
        </p>
      </div>
    </footer>
  );
}
