import type { ExhibitionCommand, ExhibitionState } from '../../shared/exhibition';
import type { DiagnosticContext } from './diagnostics';

export function diagnosticContext(state: ExhibitionState): DiagnosticContext {
  return { mirrorId: state.mirrorId ?? 'default', sessionNumber: state.sessionNumber,
    generationNumber: state.generationNumber, lookId: state.selectedLookId ?? 'none' };
}

/** Expected tuple from the existing command contract; never added to the API request. */
export function commandDiagnosticContext(state: ExhibitionState, command: ExhibitionCommand): DiagnosticContext {
  const context = diagnosticContext(state);
  if (command.action === 'begin') { context.sessionNumber++; context.generationNumber++; }
  if (command.action === 'resume' && state.providerMode === 'xmax') context.generationNumber++;
  if (command.action === 'switch' && command.lookId !== state.selectedLookId) context.generationNumber++;
  if ((command.action === 'switch' || command.action === 'select') && command.lookId) context.lookId = command.lookId;
  return context;
}

export function diagnosticsRequested(href: string): boolean {
  const url = new URL(href);
  return url.pathname.replace(/\/$/, '').endsWith('/exhibition/screen') && url.searchParams.get('diagnostics') === '1';
}
