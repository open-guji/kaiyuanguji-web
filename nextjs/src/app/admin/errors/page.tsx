import ErrorsView from './ErrorsView';

export const metadata = { robots: { index: false, follow: false } };

export default function AdminErrorsPage() {
  return <ErrorsView />;
}
