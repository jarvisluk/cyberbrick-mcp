/**
 * Semantic documentation for the CyberBrick firmware-config store actions
 * (window.app.useFirmwareConfigStore) — the surface behind
 * firmware_config_edit / firmware_edit_actions.
 *
 * Extracted from the bundle's store definition (we=Xt()(La(su(...)))) and
 * verified live. Enums:
 *   receiver role: "sender" | "receiver_1" | "receiver_2"          (Le)
 *   actuator slot: PWM1..PWM4, MOTOR1, MOTOR2, LED1, LED2,
 *                  BUZZER1, BUZZER2, CODE                            (Se)
 *   device type:   button, joystick, joystick_s, led, pwm, motor,
 *                  three_way_switch, buzzer, code                    (Me)
 *   configType:    "hardware" | "software"                           (Wl)
 *
 * Every action below is invoked as-is via firmware_config_edit with
 * positional `args` in the documented order — no adaptation layer.
 */

export const ACTION_DOCS = {
  // ---------- whole-config ----------
  setFirmwareConfig: {
    args: 'config: object',
    mutates: true,
    doc: 'Replace the whole editor config (version-checked by the app). Resets isModified=false.',
  },
  resetFirmwareConfig: {
    args: '',
    mutates: true,
    doc: 'Reset the editor config to the app\'s empty "custom" default (blank project). Sets isModified=true.',
  },
  updateFirmwareConfigName: { args: 'name: string', mutates: true, doc: 'Set config_name on the editor config (does NOT rename the saved project; use project_rename).' },
  updateFirmwareId: { args: 'id: string', mutates: true, doc: 'Point the editor config at a project id (the app does this after addFirmware).' },
  updateFirmwareUpdateTime: { args: 'time: string', mutates: true, doc: 'Set update_time string on the editor config.' },
  markAsSaved: { args: '', mutates: true, doc: 'Clear isModified. (project_save does this for you.)' },
  setIsModified: { args: 'flag: boolean', mutates: true, doc: 'Force the isModified flag.' },
  setConfigType: { args: '"hardware" | "software"', mutates: true, doc: 'Switch the editor\'s config type tab.' },

  // ---------- sender channels ----------
  updateSenderSetting: { args: 'setting: object', mutates: true, doc: 'Replace the whole sender settings object (firmwareConfig.sender).' },
  updateSenderChannel: {
    args: 'index: number, channel: object',
    mutates: true,
    doc: 'Replace sender channel at index. Channel shape: { name, device: "button"|"joystick"|"joystick_s"|"three_way_switch", data: { channel?: "x"|"y", deadzone, mid_value }, controls: [...], event: [...] }.',
  },
  removeSenderChannel: {
    args: 'index: number',
    mutates: true,
    doc: 'Clear sender channel at index to {}; if the software switch was bound to it, unbinds the switch (en=false, channel=-1).',
  },
  updateChannelControl: {
    args: 'index: number, controls: array',
    mutates: true,
    doc: 'Replace the controls array of sender channel index. Control item: { actuator: <actuator slot>, direction: "positive"|"negative", receiver: 1|2 }.',
  },
  updateUniEvents: {
    args: 'index: number, events: array',
    mutates: true,
    doc: 'Replace the event array of sender channel index. Event item: { type: "gt_mid"|"lt_mid"|..., actuator, receiver: 1|2, set_value?: [numbers] }.',
  },
  removeSenderLedSetValue: {
    args: 'actuator: string, receiver: number, value: number',
    mutates: true,
    doc: 'Remove one set_value number from every LED event targeting (actuator, receiver).',
  },
  removeSenderBuzzerSetValue: {
    args: 'actuator: string, receiver: number, value: number',
    mutates: true,
    doc: 'Remove one set_value number from every BUZZER event targeting (actuator, receiver).',
  },
  removeControlByActuator: {
    args: 'actuator: string, receiverKey: string',
    mutates: true,
    doc: 'Clear a receiver actuator slot and strip every sender control/event that references it. receiverKey: "receiver_1"|"receiver_2".',
  },

  // ---------- switches (software 3-pos switch) ----------
  changeSwitchState: { args: 'en: boolean', mutates: true, doc: 'Enable/disable the software switch (firmwareConfig.switches.en).' },
  updateSwitchList: { args: 'list: array', mutates: true, doc: 'Replace switches.list — [{ state: "on"|"off", name?: string }, ...] (index 0 → receiver_1, index 1 → receiver_2).' },
  updateSwitchChannel: { args: 'channelIndex: number', mutates: true, doc: 'Bind the software switch to sender channel index (-1 unbinds).' },

  // ---------- receiver actuators ----------
  updateReceiverChannel: {
    args: 'receiverKey: string, actuator: string, setting: object',
    mutates: true,
    doc: 'Set one actuator slot on a receiver. receiverKey: "receiver_1"|"receiver_2"; actuator: PWM1..4/MOTOR1/2/LED1/2/BUZZER1/2/CODE; setting replaces the slot object.',
  },
  updateReceiver1Setting: { args: 'setting: object', mutates: true, doc: 'Replace the whole receiver_1 settings object.' },
  updateReceiver2Setting: { args: 'setting: object', mutates: true, doc: 'Replace the whole receiver_2 settings object.' },
  updateReceiverDeviceName: { args: 'receiverKey: string, actuator: string, name: string', mutates: true, doc: 'Set a display name on a receiver actuator slot.' },

  // ---------- motor advance (encoder/PID-style extra config) ----------
  updateAdvanceMotor: {
    args: 'actuator: string, receiverKey: string, config: object',
    mutates: true,
    doc: 'Set advance_motor_config on a MOTOR slot. NOTE arg order: (actuator, receiverKey, config).',
  },
  updateMotorAdvanceChecked: {
    args: 'actuator: string, receiverKey: string, en: boolean',
    mutates: true,
    doc: 'Enable/disable advance_motor_config.en on a MOTOR slot (only valid for MOTOR1/MOTOR2). Arg order: (actuator, receiverKey, en).',
  },

  // ---------- hardware mapping (device ↔ role binding) ----------
  addHardwareMapping: {
    args: 'mapping: object',
    mutates: true,
    doc: 'Add/replace a hardware binding { hardwareKey: "sender"|"receiver_1"|"receiver_2", boardId: deviceId, ... }. Replaces by hardwareKey and by boardId (unpairs displaced boards).',
  },
  removeHardwareMapping: { args: 'hardwareKey: string', mutates: true, doc: 'Remove the binding for a role ("sender"|"receiver_1"|"receiver_2").' },
  removeHardwareMappingByDeviceId: { args: 'boardId: string', mutates: true, doc: 'Remove the binding for a device id.' },
  resetHardwareMap: { args: '', mutates: true, doc: 'Clear all hardware bindings.' },

  // ---------- getters (read-only, safe in firmware_config_edit too) ----------
  getSenderChannel: { args: 'index: number', mutates: false, doc: 'Read sender channel at index.' },
  getSenderChannels: { args: '', mutates: false, doc: 'List sender channels [{name, deviceType, channelId}] (deduped).' },
  getChannelControl: { args: 'index: number', mutates: false, doc: 'Read controls of sender channel index (each item +channelId).' },
  getUniEvents: { args: 'index: number', mutates: false, doc: 'Read events of sender channel index (each item +channelId+pwmType).' },
  getAllControls: { args: '', mutates: false, doc: 'All controls across all sender channels.' },
  getAllEvents: { args: '', mutates: false, doc: 'All events across all sender channels.' },
  getReceiverChannel: { args: 'receiverKey: string, actuator: string', mutates: false, doc: 'Read one actuator slot object.' },
  getReceiverChannelEn: { args: 'receiverKey: string, actuator: string', mutates: false, doc: 'Read actuator slot .en flag (default false).' },
  getServoType: { args: 'receiverKey: string, actuator: string', mutates: false, doc: 'Device type of an actuator slot.' },
  getReceiverDeviceName: { args: 'receiverKey: string, actuator: string', mutates: false, doc: 'Display name of an actuator slot (falls back to the slot key).' },
  getSwitchList: { args: '', mutates: false, doc: 'Read switches.list.' },
  getSwitchChannel: { args: '', mutates: false, doc: 'Read the switch-bound sender channel index.' },
  getSwitchChannelId: { args: '', mutates: false, doc: 'Alias of getSwitchChannel.' },
  getSwitchController: { args: '', mutates: false, doc: 'Sender channels usable as switch controllers [{name, channelId, deviceType}].' },
  getAvailableReceiver: { args: '', mutates: false, doc: 'Receiver roles whose switch state is "on" (e.g. ["receiver_1"]).' },
  getConnectedActuator: { args: 'receiverKey: string, exclude: string[]', mutates: false, doc: 'Enabled actuator slots on a receiver, excluding `exclude` list [{value, name, pwmType?}].' },
  getControlByActuator: { args: 'actuator: string, receiverKey: string', mutates: false, doc: 'Comma-separated sender channel names controlling an actuator slot.' },
  getAdvanceMotor: { args: 'actuator: string, receiverKey: string', mutates: false, doc: 'Read advance_motor_config (NOTE arg order: actuator first).' },
  getMotorAdvanceChecked: { args: 'actuator: string, receiverKey: string', mutates: false, doc: 'Read advance_motor_config.en (MOTOR1/MOTOR2 only).' },
  getLedEffects: { args: 'receiverKey: string', mutates: false, doc: 'LED effect catalog for a receiver: { LED1: [{effect, effect_name}], LED2: [...] }.' },
  getCodeEffects: { args: 'receiverKey: string', mutates: false, doc: 'CODE slot effect catalog [{effect, effect_name, code}].' },
  getChannelIdByName: { args: 'name: string', mutates: false, doc: 'First sender channel index with this name (-1 if none).' },
  getChannelNameByIndex: { args: 'index: number', mutates: false, doc: 'Sender channel name at index.' },
  getSenderChannelTypeByIndex: { args: 'index: number', mutates: false, doc: 'Sender channel device type at index.' },
  findChannelIndicesByName: { args: 'name: string', mutates: false, doc: 'Map of data.channel ("x"/"y") → channel index for all channels named `name`.' },
  isSenderChannelHasEvent: { args: 'index: number', mutates: false, doc: 'True if sender channel index has ≥1 event.' },
  getHardwareName: { args: 'hardwareKey: string', mutates: false, doc: 'Human name for a role (switch list name or localized default).' },
  getBoundDevice: { args: 'hardwareKey: string', mutates: false, doc: 'Device record bound to a role (via deviceListStore).' },
  getIsBindDevice: { args: 'hardwareKey: string', mutates: false, doc: 'True if a device is bound to the role.' },
  getExistHardwareMappingDeviceId: { args: '', mutates: false, doc: 'All boardIds present in hardware mappings.' },
  getFirmwareConfigName: { args: '', mutates: false, doc: 'Editor config name (default "config").' },
};

/** Grouping shown to the Agent by firmware_edit_actions. */
export const ACTION_GROUPS = {
  whole_config: ['setFirmwareConfig', 'resetFirmwareConfig', 'updateFirmwareConfigName', 'updateFirmwareId', 'updateFirmwareUpdateTime', 'markAsSaved', 'setIsModified', 'setConfigType'],
  sender_channels: ['updateSenderSetting', 'updateSenderChannel', 'removeSenderChannel', 'updateChannelControl', 'updateUniEvents', 'removeSenderLedSetValue', 'removeSenderBuzzerSetValue', 'removeControlByActuator'],
  switch: ['changeSwitchState', 'updateSwitchList', 'updateSwitchChannel'],
  receiver_actuators: ['updateReceiverChannel', 'updateReceiver1Setting', 'updateReceiver2Setting', 'updateReceiverDeviceName', 'updateAdvanceMotor', 'updateMotorAdvanceChecked'],
  hardware_mapping: ['addHardwareMapping', 'removeHardwareMapping', 'removeHardwareMappingByDeviceId', 'resetHardwareMap'],
  read_only: Object.keys(ACTION_DOCS).filter(k => ACTION_DOCS[k].mutates === false),
};

export function actionCatalog() {
  return {
    enums: {
      receiverKey: ['sender', 'receiver_1', 'receiver_2'],
      actuator: ['PWM1', 'PWM2', 'PWM3', 'PWM4', 'MOTOR1', 'MOTOR2', 'LED1', 'LED2', 'BUZZER1', 'BUZZER2', 'CODE'],
      device: ['button', 'joystick', 'joystick_s', 'led', 'pwm', 'motor', 'three_way_switch', 'buzzer', 'code'],
      configType: ['hardware', 'software'],
    },
    groups: ACTION_GROUPS,
    actions: ACTION_DOCS,
  };
}
