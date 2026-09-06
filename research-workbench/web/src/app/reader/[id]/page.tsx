import { ReaderClient } from "./reader-client";

export default async function ReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReaderClient documentId={id} />;
}
