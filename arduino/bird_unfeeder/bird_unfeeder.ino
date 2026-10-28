/*
 * Main loop for the bird unfeeder
 */

#include "constants.h"
#include "motor.h"
#include "motor_routines.h"
#include "limit_switch.h"
#include "wifi_util.h"
#include "telemetry.h"
#include "clock_state.h"
#include "secrets.h"

constexpr int POLLING_PERIOD_US = 1 * 60 * 1000 * 1000;

bool run_setup() {
  Serial.begin(115200);
  addTelemetryEvent(TelemetryEvent::WOKE_UP);

  pinMode(LIMIT_SWITCH_PIN, INPUT_PULLUP);
  pinMode(MOTOR_DRIVER_SLEEP_PIN, OUTPUT);
  pinMode(MOTOR_DRIVER_A_INPUT_ONE, OUTPUT);
  pinMode(MOTOR_DRIVER_A_INPUT_TWO, OUTPUT);

  digitalWrite(MOTOR_DRIVER_SLEEP_PIN, LOW);

  bool wifi_success = setup_wifi();
  if (!wifi_success) {
    Serial.println("Failed to setup wifi");
    return false;
  }
  return true;
}

void finish(bool unrecoverable_error) {
  addTelemetryEvent(TelemetryEvent::ENTERING_SLEEP);
  post(TELEMETRY_URL, getTelemetryPayload());
  if (!unrecoverable_error) {
    esp_sleep_enable_timer_wakeup(POLLING_PERIOD_US);
  }
  esp_deep_sleep_start();
}

void maybe_adjust_weight() {
  bool someone_home = anyone_home();
  addTelemetryEvent(anyone_home ? TelemetryEvent::FOUND_CLOCK_STATE_HOME : TelemetryEvent::FOUND_CLOCK_STATE_AWAY);
  bool weight_up = limit_switch_pressed();

  if (someone_home && weight_up) {
    lower_weight();
  } else if (!someone_home && !weight_up) {
    bool successful_raise = raise_weight();
    if (!successful_raise) {
      // Motor didn't hit limit switch - stuck?
      // Don't want to grind forever. Sleep indefinitely instead.
      finish(/*unrecoverable_error=*/true);
    }
  }
}

void setup() {
  bool setup_success = run_setup();
  if (setup_success) {
    maybe_adjust_weight();
  }
  finish(/*unrecoverable_error=*/false);
}

void loop() {
  // no loop
}
