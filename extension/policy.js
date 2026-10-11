// Automatic fill policy, kept pure so it can be tested outside the browser.
// Every condition must hold. Anything unknown means the user decides by clicking Fill.
export function autoFillAllowed(data) {
  return Boolean(
    data?.found &&
    data.confidence === 'high' &&
    data.senderMatchesSite === true && // sender's domain belongs to this site
    data.senderVerified === true && // Proton recorded DMARC pass for that domain
    data.knownSender === true // a known one-time-code sender, not a heuristic match
  );
}
