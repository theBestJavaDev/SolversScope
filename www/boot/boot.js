/*
  Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
  http://github.com/Mechanical-Advantage

  Use of this source code is governed by a BSD
  license that can be found in the LICENSE file
  at the root directory of this project.
*/

// SolversScope boot screen: the icon's lens spins like a loading symbol, then the app is revealed. Hides when the
// animation has finished AND the page has loaded (or after a failsafe timeout).
(function () {
  var screen = document.getElementById("boot-screen");
  if (!screen) return;

  var animationDone = false;
  var pageLoaded = document.readyState === "complete";
  var hidden = false;

  function hide() {
    if (hidden) return;
    hidden = true;
    screen.classList.add("boot-hide");
    window.setTimeout(function () {
      screen.remove();
    }, 600);
  }
  function check() {
    if (animationDone && pageLoaded) hide();
  }

  // The lens spin ends the animation
  var lens = screen.querySelector(".iris");
  if (lens) {
    lens.addEventListener("animationend", function () {
      animationDone = true;
      check();
    });
  } else {
    animationDone = true;
  }
  if (!pageLoaded) {
    window.addEventListener("load", function () {
      pageLoaded = true;
      check();
    });
  }

  // Failsafes: never trap the user behind the splash
  window.setTimeout(function () {
    animationDone = true;
    check();
  }, 5000);
  window.setTimeout(hide, 12000);
  screen.addEventListener("click", hide);
})();
