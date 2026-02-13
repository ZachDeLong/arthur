"use client";

interface ParticipantBadgeProps {
  displayIdentifier: string;
  tier: string;
  contentCount: number;
  engagementCount: number;
  enrolledAt: string;
}

export function ParticipantBadge({
  displayIdentifier,
  tier,
  contentCount,
  engagementCount,
  enrolledAt,
}: ParticipantBadgeProps) {
  return (
    <div>
      <h3>{displayIdentifier}</h3>
      <span>{tier}</span>
      <p>
        {contentCount} items authored | {engagementCount} engagements
      </p>
      <time dateTime={enrolledAt}>
        Joined {new Date(enrolledAt).toLocaleDateString()}
      </time>
    </div>
  );
}
