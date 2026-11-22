import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchResults } from "@/components/search/search-results";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage(props: PageProps<"/search">) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <PageHeading
        title="Find stays, buses and guides"
        subtitle="Prices are per unit, before service charge and VAT."
      />
      <Suspense
        fallback={
          <p className="text-sm text-slate-600" aria-live="polite">
            Searching…
          </p>
        }
      >
        <SearchResults searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}
