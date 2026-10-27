import { Guilloche } from '../../components/Guilloche';
import { installmentRange, voidInstallments } from '../../lib/certificate';
import { zatToZecString } from '../../lib/zat';
import { fmt, RUN2, shortTxid } from './data';

/**
 * Run 2's cancellation certificate as a specimen on Paper, in both themes. Its rosette is
 * drawn from the cancel transaction's own id; a nullifier is never shown here.
 */
export function CertificateSpecimen() {
  // The cancel spent the change of installment 1, so 2 onwards can never be valid.
  const never = installmentRange(voidInstallments(1, RUN2.count));
  return (
    <figure className="cert-specimen" data-reveal="rise">
      <div className="cert-paper">
        <div className="cert-body">
          <Guilloche seed={RUN2.cancelTxid} className="cert-rosette" />
          <p className="cert-kind">Cancellation certificate</p>
          <p className="cert-lead">Cancelled at block {fmt(RUN2.cancelHeight)}.</p>
          <p className="cert-lead">Installments {never} can never be valid.</p>
          <p className="cert-line">
            {fmt(RUN2.refundedZats)} zats ({zatToZecString(RUN2.refundedZats)} TAZ) returned to the payer's own address.
          </p>
          <p className="cert-tx">Cancel transaction {shortTxid(RUN2.cancelTxid)}</p>
        </div>
        <div className="cert-stub" aria-hidden="true">
          <span>block {fmt(RUN2.cancelHeight)}</span>
        </div>
      </div>
      <figcaption className="cert-foot">From a testnet cancel on {RUN2.date}. Each certificate's rosette is drawn from its own transaction.</figcaption>
    </figure>
  );
}
