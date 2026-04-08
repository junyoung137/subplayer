/**
 * youtubeUtils.ts
 *
 * YouTube 관련 순수 유틸 함수 모음.
 * YouTubePlayer.tsx와 UrlInputModal.tsx 양쪽에서 import해도
 * 순환 의존성이 생기지 않도록 별도 파일로 분리.
 */

/**
 * 다양한 YouTube URL/ID 형식에서 11자리 videoId를 추출.
 *
 * 지원 형식:
 *   https://www.youtube.com/watch?v=XXXXXXXXXXX
 *   https://youtu.be/XXXXXXXXXXX
 *   https://www.youtube.com/shorts/XXXXXXXXXXX
 *   https://m.youtube.com/watch?v=XXXXXXXXXXX
 *   XXXXXXXXXXX  (11자리 ID 직접 입력)
 */
export function parseYoutubeId(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
  
    // youtu.be/ID
    const short = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (short) return short[1];
  
    // youtube.com/watch?v=ID
    const full = trimmed.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (full) return full[1];
  
    // youtube.com/shorts/ID
    const shorts = trimmed.match(/shorts\/([A-Za-z0-9_-]{11})/);
    if (shorts) return shorts[1];
  
    // 11자리 ID 직접 입력
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  
    return null;
  }
  
  export function isYoutubeUrl(input: string): boolean {
    const t = input.trim();
    return (
      t.includes("youtube.com") ||
      t.includes("youtu.be") ||
      /^[A-Za-z0-9_-]{11}$/.test(t)
    );
  }