export type BrowserKind = 'chromium-desktop' | 'other-desktop' | 'mobile';

interface UADataBrand {
    brand: string;
    version: string;
}
interface UAData {
    brands?: UADataBrand[];
    mobile?: boolean;
}

export function detectBrowser(): BrowserKind {
    const uaData = (navigator as Navigator & { userAgentData?: UAData })
        .userAgentData;
    const ua = navigator.userAgent;

    const isMobile =
        uaData?.mobile ?? /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    if (isMobile) return 'mobile';

    const isChromium = uaData?.brands
        ? uaData.brands.some((b) => b.brand === 'Chromium')
        : /Chrome\/|Chromium\//.test(ua);
    return isChromium ? 'chromium-desktop' : 'other-desktop';
}
