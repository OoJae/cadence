import { useDocumentTitle } from '../hooks';
import { Link } from '../router';

export function NotFound() {
  useDocumentTitle('Not found');
  return (
    <div className="page container narrow">
      <div className="empty-state lost">
        <span className="kicker plain">404</span>
        <h1 className="h2">Nothing was signed for this page.</h1>
        <p className="muted">If you were sent a subscription link, check that it was copied in full, including everything after the #.</p>
        <Link to="/" className="btn">
          Back to the overview
        </Link>
      </div>
    </div>
  );
}
