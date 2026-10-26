import { setAriaStrings, setKeyboardDragTrigger, type AriaStrings } from 'svelte-dnd-action';
import { t } from '$lib/i18n';

/**
 * Board-wide drag settings. The renderer has no other drag zones, so the
 * keyboard trigger and the announcements are global. Space starts a keyboard
 * drag; Enter stays free to open a card. Call again when the locale changes.
 */
export function configureBoardDnd(): void {
  setKeyboardDragTrigger('space');
  const strings: AriaStrings = {
    dragStarted: ({ itemLabel, zoneLabel, canMoveBetweenZones }) =>
      t('board.dnd.dragStarted', {
        itemLabel,
        zoneLabel,
        between: canMoveBetweenZones ? t('board.dnd.dragStartedBetween') : '',
      }),
    movedToPosition: ({ itemLabel, zoneLabel, position }) =>
      t('board.dnd.movedToPosition', { itemLabel, zoneLabel, position }),
    movedToZoneEnd: ({ itemLabel, zoneLabel }) =>
      t('board.dnd.movedToZoneEnd', { itemLabel, zoneLabel }),
    movedToZoneStart: ({ itemLabel, zoneLabel }) =>
      t('board.dnd.movedToZoneStart', { itemLabel, zoneLabel }),
    dropped: ({ itemLabel }) => t('board.dnd.dropped', { itemLabel }),
    zoneActiveInstruction: t('board.dnd.zoneActiveInstruction'),
    zoneDragDisabledInstruction: t('board.dnd.zoneDragDisabledInstruction'),
  };
  setAriaStrings(strings);
}
