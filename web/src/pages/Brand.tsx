import { PageHead } from '../components/ui';
import { useDocumentTitle } from '../hooks';

export function Brand() {
  useDocumentTitle('Brand');
  return (
    <div className="container page">
      <PageHead kicker="Brand" title="The pulled rung" />
    </div>
  );
}
