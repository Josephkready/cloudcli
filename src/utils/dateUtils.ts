import { TFunction } from 'i18next';

/**
 * Compact relative age (`<1m`, `Xm`, `Xhr`, `Xd`) for a dense list row.
 *
 * The sidebar conversation rows, the per-project session rows, the archived
 * rows and the empty-state list all show this, and each had grown its own copy
 * of the band table — so a change to one band silently applied to some rows and
 * not others. Returns `''` for non-finite or non-positive timestamps.
 */
export const formatCompactAge = (activityTime: number, now: Date): string => {
  if (!Number.isFinite(activityTime) || activityTime <= 0) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, now.getTime() - activityTime) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  return `${Math.floor(diffInHours / 24)}d`;
};

/**
 * `formatCompactAge` for the call sites that hold an ISO string rather than a
 * parsed timestamp. Missing and unparseable dates render as `''`.
 */
export const formatCompactAgeFromDate = (
  dateString: string | null | undefined,
  now: Date,
): string => {
  if (!dateString) {
    return '';
  }

  return formatCompactAge(new Date(dateString).getTime(), now);
};

export const formatTimeAgo = (dateString: string, currentTime: Date, t: TFunction) => {
  const date = new Date(dateString);
  const now = currentTime;

  // Check if date is valid
  if (isNaN(date.getTime())) {
    return t ? t('status.unknown') : 'Unknown';
  }

  const diffInMs = now.getTime() - date.getTime();
  const diffInSeconds = Math.floor(diffInMs / 1000);
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInSeconds < 60) return t ? t('time.justNow') : 'Just now';
  if (diffInMinutes === 1) return t ? t('time.oneMinuteAgo') : '1 min ago';
  if (diffInMinutes < 60) return t ? t('time.minutesAgo', { count: diffInMinutes }) : `${diffInMinutes} mins ago`;
  if (diffInHours === 1) return t ? t('time.oneHourAgo') : '1 hour ago';
  if (diffInHours < 24) return t ? t('time.hoursAgo', { count: diffInHours }) : `${diffInHours} hours ago`;
  if (diffInDays === 1) return t ? t('time.oneDayAgo') : '1 day ago';
  if (diffInDays < 7) return t ? t('time.daysAgo', { count: diffInDays }) : `${diffInDays} days ago`;
  return date.toLocaleDateString();
};