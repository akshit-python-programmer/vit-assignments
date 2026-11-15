// Static ads shown in the download dialog while the PDF is being compressed.
// Edit this list to change them — one is picked at random each time.
//   image: path (e.g. "ads/my-banner.png", put the file in the ads/ folder) or full URL. Best size: 728×180 or similar wide banner.
//   link:  where a click goes (opens in a new tab). Leave "" for no link.
//   alt:   short description of the ad.
// Set AD_SECONDS to how long the ad must be visible before the download unlocks (0 = no wait).
// Remove every entry (window.APE_ADS = []) to turn ads off completely.
window.APE_AD_SECONDS = 5;
window.APE_ADS = [
  {
    image: 'ads/house-ad.svg',
    link: 'https://akshitkumarlall.com',
    alt: 'Built by Akshit Kumar Lall — see more projects',
  },
];
