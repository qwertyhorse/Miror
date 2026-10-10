import type { ExhibitionUiSkinPreset, ExhibitionState } from '../../shared/exhibition';
import { appUrl } from '../versionScope';

export const MIRROR_SKIN_LABELS: Record<ExhibitionUiSkinPreset, string> = {
  crystal: '水晶浅紫',
  brand: '品牌紫',
};

export function mirrorSkin(state: ExhibitionState): ExhibitionUiSkinPreset | 'custom' {
  return state.settings.uiSkin ? 'custom' : state.settings.uiSkinPreset ?? 'crystal';
}

export function MirrorSkinThumbnail({ preset }: { preset: ExhibitionUiSkinPreset }) {
  return <span className="ex-ui-skin-thumbnail" data-skin={preset} aria-hidden="true">
    <img src={appUrl('/assets/exhibition/openbuy-ai-logo-rgb.png')} alt="" />
    <span className="ex-ui-skin-thumbnail-stage" />
  </span>;
}
