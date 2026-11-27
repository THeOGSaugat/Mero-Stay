import { Suspense } from "react";
import { ListingDetail } from "@/components/search/listing-detail";

export default function ListingPage(props: PageProps<"/listings/[id]">) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <Suspense
        fallback={
          <p className="text-sm text-muted" aria-live="polite">
            Loading listing…
          </p>
        }
      >
        <ListingDetail params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}
