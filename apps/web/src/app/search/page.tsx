import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchResults } from "@/components/search/search-results";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage(props: PageProps<"/search">) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
          <p className="text-sm text-muted" aria-live="polite">
            Searching…
          </p>
        </div>
      }
    >
      <SearchResults searchParams={props.searchParams} />
    </Suspense>
  );
}
