import { Suspense } from "react";
import { ListingDetail } from "@/components/search/listing-detail";

export default function ListingPage(props: PageProps<"/listings/[id]">) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Suspense
        fallback={
          <p className="text-sm text-slate-600" aria-live="polite">
            Loading listing…
          </p>
        }
      >
        <ListingDetail params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}
