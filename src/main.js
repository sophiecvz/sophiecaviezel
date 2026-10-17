const accessTrigger = document.querySelector('#access-trigger');
const accessWarning = document.querySelector('#access-warning');

if (accessTrigger && accessWarning) {
  const continueLink = accessWarning.querySelector('a');

  accessTrigger.addEventListener('click', () => {
    accessWarning.hidden = false;
    accessTrigger.hidden = true;

    if (continueLink) {
      continueLink.focus();
    }
  });
}
