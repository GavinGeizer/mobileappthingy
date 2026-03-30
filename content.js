/*
  The purpose of this file is to provide the content script for Server 3.    

  Note that this extension uses an endpoint different than the server code given.
  manifest.json must be updated to test your server code.

  comments for functions in this file are in JSDoc format, which is a common way to document JavaScript code.
  you can find out all the translations here: https://jsdoc.app/tags-param.html - Gavin

  Author: Terry, Gavin, Ajay, Matt
*/

/* global variables */
let globalVoices = [];
let pressTimer = null;

/* global constants */
const LONG_PRESS_MS = 600; // 0.6 sec gives a safe margin of the typical 0.5 sec, we can easily adjust this if we find it is too short or long during testing.
const LANGUAGE_NAME = "Google UK English Female"; // client preferred soft female voice

/**
 * Loads the currently available speech synthesis voices into memory.
 *
 * @returns {void}
 */
function loadVoices() {
  globalVoices = speechSynthesis.getVoices();
}

/**
 * Determines whether an event target is an image element.
 *
 * @param {EventTarget | null} target - The target to inspect.
 * @returns {target is HTMLImageElement} `true` when the target is an image element.
 */
function isImageElement(target) {
  // HTMLImageElement is a built-in interface that represents <img> elements in the DOM.
  // better to break this out into a function for readability.
  return target instanceof HTMLImageElement;
}

/**
 * Sends the selected image to the background script and speaks the response.
 *
 * @param {HTMLImageElement} img - The image element that was long-pressed.
 * @param {PointerEvent} event - The pointer event that started the long press.
 * @returns {Promise<void>}
 */
async function analyzePressedImage(img, event) {
  // prevents default actions like a picture being a link
  event.preventDefault();
  // prevents propagation that would happen with a nested div being clicked and
  // both the actions associated with the inner div and outer div take place
  event.stopPropagation();

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "ANALYZE_IMAGE_URL",
      // img.currentSrc might contain the actual image being displayed.
      // If it doesn't then it is equal to "" which is falsy.
      // This can be different than img.src which refers to the attribute src.
      // img.src can be differnt when, for example, there are different sized
      // images for different sized devices.
      // url will be currentSrc when currentSrc !== "" , otherwise it will be src
      url: img.currentSrc || img.src,
    });

    // if resp is null or undefined or false
    // then if resp is not null or undefined
    //      then use error description
    //      else use "Unknown error"
    if (!resp?.ok) throw new Error(resp?.error || "Unknown error");

    speak(resp.description);
  } catch (err) {
    console.error("Analyze failed:", err);
  }
}

/**
 * Runs the delayed image analysis step after a long press.
 *
 * @param {HTMLImageElement} img - The image element that was pressed.
 * @param {PointerEvent} event - The original pointer event.
 * @returns {void}
 */
function runLongPressAnalysis(img, event) {
  void analyzePressedImage(img, event);
}

/*
  onvoiceschanged is an event listener that activates only when the browser
  is ready to set the globalVoices variable immediately when the line of
  code is executed.

  An important note here is that globalVoices = speechSynthesis.getVoices();
  does not need to execute for the onvoiceschanged event to eventually fire.
  onvoiceschanged happens asynchronously and independent of your code.
*/
speechSynthesis.onvoiceschanged = loadVoices; // wait for event
loadVoices(); // try right away just in case. But you might get an empty array []

/**
 * Starts the long-press timer when the user presses an image.
 *
 * @param {PointerEvent} pointerEvent - The pointer event fired by the document.
 * @returns {void}
 */
function handlePointerDown(pointerEvent) {
  const img = pointerEvent.target;
  // if img is null or undefined or img.tagName is not IMG return
  if (!isImageElement(img)) return;

  pressTimer = setTimeout(runLongPressAnalysis, LONG_PRESS_MS, img, pointerEvent);
}

/**
 * Clears the active long-press timer.
 * we use this function for readability.
 *
 * @returns {void}
 */
function clearPressTimer() {
  clearTimeout(pressTimer);
}

/**
 * Prevents the browser context menu from appearing on long press.
 *
 * @param {MouseEvent} pointerEvent - The context menu event fired by the document.
 * @returns {void}
 */
function handleContextMenu(pointerEvent) {
  pointerEvent.preventDefault();
}

/**
 * Checks whether a voice matches the preferred voice name.
 *
 * @param {SpeechSynthesisVoice} voice - The voice candidate to test.
 * @returns {boolean} `true` when the voice matches the preferred name.
 */
function isPreferredVoice(voice) {
  return voice.name === LANGUAGE_NAME;
}

/**
 * Speaks a description using the preferred browser voice when available.
 *
 * @param {string} text - The text to speak aloud.
 * @returns {void}
 */
function speak(text) {
  speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  // u.lang used when you want a voice but you let the browser choose something close
  // It's here only as information, and is not required for the app
  u.lang = "en-GB";
  u.rate = 0.95;
  u.pitch = 1.0;
  u.volume = 1.0;

  const voice = globalVoices.find(isPreferredVoice);

  if (voice) {
    u.voice = voice;
  } else {
    console.log("Voice not found, using default");
  }

  speechSynthesis.speak(u);
}

// Listen for messages from the content script.
document.addEventListener("pointerdown", handlePointerDown);
document.addEventListener("pointerup", clearPressTimer);
document.addEventListener("pointercancel", clearPressTimer);
document.addEventListener("contextmenu", handleContextMenu);
