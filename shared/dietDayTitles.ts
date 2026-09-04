import type { DietDayColor } from './types.ts'

/**
 * Human-readable verdict per day colour.
 *
 * Shared because two places need it: the classifier puts it on every
 * /day-summary row, and the web client has to label a `recommend` card, whose
 * meta carries only the colour. Keeping one map means the chat card and the
 * History dot can never disagree about what "light_green" is called.
 */
export const DIET_DAY_TITLES: Record<DietDayColor, string> = {
  gray: 'Нет данных',
  blue: 'Сильный недобор',
  green: 'Отличный день',
  light_green: 'Хороший день',
  yellow: 'Мелкая погрешность',
  orange: 'Заметное отклонение',
  red: 'Серьёзное отклонение',
}
