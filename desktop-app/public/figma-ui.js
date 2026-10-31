const tetherWordmarkUrl = new URL('./figma-assets/tether-wordmark.png', import.meta.url).href;
const emptyCaptureIconUrl = new URL('./figma-assets/empty-captures-icon.svg', import.meta.url).href;

function applyTetherFigmaPresentation() {
  const logo = document.querySelector('.logo-section');
  if (logo && !logo.querySelector('.tether-wordmark')) {
    const wordmark = document.createElement('img');
    wordmark.className = 'tether-wordmark';
    wordmark.alt = 'TETHER';
    wordmark.src = tetherWordmarkUrl;
    logo.prepend(wordmark);
  }

  const waiting = document.querySelector('.waiting-container');
  if (waiting) {
    const heading = waiting.querySelector('h3');
    if (heading && heading.textContent !== 'Tether is napping.') {
      heading.textContent = 'Tether is napping.';
    }
    const description = waiting.querySelector('p');
    const offlineCopy = 'Snap a photo on your phone and it’ll bounce right here. Nothing leaves the room — no cloud, no upload.';
    if (description && description.textContent !== offlineCopy) {
      description.textContent = offlineCopy;
    }
    if (description && !waiting.querySelector('.figma-feature-chips')) {
      const featureHeading = document.createElement('strong');
      featureHeading.className = 'figma-feature-heading';
      featureHeading.textContent = 'Hero Features:';
      const chips = document.createElement('div');
      chips.className = 'figma-feature-chips';
      for (const label of ['One-click BG Remover', 'Pass-port photo editing', 'Print-ready layouts']) {
        const chip = document.createElement('span');
        chip.className = 'figma-feature-chip';
        chip.textContent = label;
        chips.appendChild(chip);
      }
      description.insertAdjacentElement('afterend', featureHeading);
      featureHeading.insertAdjacentElement('afterend', chips);
    }
  }

  const emptyCapture = [...document.querySelectorAll('.gallery-reel > div:not(.gallery-item)')]
    .find((element) => element.textContent.includes('No photos captured'));
  if (emptyCapture && !emptyCapture.classList.contains('empty-captures')) {
    emptyCapture.className = 'empty-captures';
    emptyCapture.replaceChildren();

    const icon = document.createElement('img');
    icon.className = 'empty-captures-icon';
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    icon.src = emptyCaptureIconUrl;

    const title = document.createElement('strong');
    title.className = 'empty-captures-title';
    title.textContent = 'Nothing here yet.';

    const description = document.createElement('p');
    description.className = 'empty-captures-description';
    description.textContent = 'Photos you snap from your phone will land here, in order. Locally only. No cloud. No account. No upload.';
    emptyCapture.append(icon, title, description);
  }

  const devicesHeading = document.querySelector('.connected-device-panel > h3');
  if (devicesHeading && devicesHeading.textContent !== 'Devices') {
    devicesHeading.textContent = 'Devices';
  }
}

applyTetherFigmaPresentation();
const tetherUiObserver = new MutationObserver(applyTetherFigmaPresentation);
tetherUiObserver.observe(document.getElementById('root') || document.documentElement, {
  childList: true,
  subtree: true
});
window.addEventListener('pagehide', () => tetherUiObserver.disconnect(), { once: true });
