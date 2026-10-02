import { Workspace } from "@/components/lab/workspace/Workspace";

export default async function WorkspacePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <Workspace key={projectId} projectId={projectId} />;
}
