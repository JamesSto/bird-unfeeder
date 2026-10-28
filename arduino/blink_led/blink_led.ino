bool is_switch_on() {
  return digitalRead(8) == 0;
}

bool motor_on = false;
bool dir = true;

void setup() {
  Serial.begin(115200);
  pinMode(8, INPUT_PULLUP);
  pinMode(4, OUTPUT);
  pinMode(5, OUTPUT);
  digitalWrite(4, 0);
  digitalWrite(5, 0);
}

void loop() {
  bool switch_on = is_switch_on();
  if (switch_on && !motor_on) {
    if (dir) {
      digitalWrite(4, 1);
      digitalWrite(5, 0);
    } else {
      digitalWrite(4, 0);
      digitalWrite(5, 1);
    }
    motor_on = true;
  } else if (!switch_on && motor_on) {
    digitalWrite(4, 0);
    digitalWrite(5, 0);
    Serial.println("OFF");
    dir = !dir;
    motor_on = false;
  }
  delay(500);
}
