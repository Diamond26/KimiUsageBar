import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class KimiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Panel',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // ---- which elements appear in the panel ----
        const elements = new Adw.PreferencesGroup({
            title: 'Panel elements',
            description: 'Choose what to show in the top bar.',
        });
        page.add(elements);

        elements.add(this._switchRow(settings, 'show-icon',
            'Show Kimi logo', 'Display the Kimi logo icon in the panel.'));

        const gaugeRow = new Adw.ComboRow({
            title: 'Usage gauge',
            subtitle: 'Which gauge to draw in the panel.',
            model: new Gtk.StringList({strings: ['Circle', 'Bar', 'None']}),
        });
        const gaugeValues = ['ring', 'bar', 'none'];
        gaugeRow.selected = Math.max(0, gaugeValues.indexOf(settings.get_string('panel-gauge')));
        gaugeRow.connect('notify::selected', () => {
            settings.set_string('panel-gauge', gaugeValues[gaugeRow.selected]);
        });
        elements.add(gaugeRow);

        elements.add(this._switchRow(settings, 'show-percentage',
            'Show usage text', 'Display the usage percentage of the panel window (e.g. "42%") next to the gauge.'));
        elements.add(this._switchRow(settings, 'show-reset',
            'Show time until reset', 'Display the time left before the panel window resets.'));
        elements.add(this._switchRow(settings, 'show-monthly-budget',
            'Show monthly overage budget', 'Display a "Monthly overage budget" row in the popup, when Kimi reports one.'));

        // ---- behaviour ----
        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);

        const windowRow = new Adw.ComboRow({
            title: 'Panel reflects',
            subtitle: 'Which window drives the panel gauge and color.',
            model: new Gtk.StringList({strings: ['5-hour', 'Weekly']}),
        });
        const windowValues = ['five-hour', 'weekly'];
        windowRow.selected = Math.max(0, windowValues.indexOf(settings.get_string('panel-window')));
        windowRow.connect('notify::selected', () => {
            settings.set_string('panel-window', windowValues[windowRow.selected]);
        });
        behaviour.add(windowRow);

        const posRow = new Adw.ComboRow({
            title: 'Panel position',
            subtitle: 'Which section of the top bar the indicator sits in.',
            model: new Gtk.StringList({strings: ['Left', 'Center', 'Right']}),
        });
        const posValues = ['left', 'center', 'right'];
        posRow.selected = Math.max(0, posValues.indexOf(settings.get_string('panel-position')));
        posRow.connect('notify::selected', () => {
            settings.set_string('panel-position', posValues[posRow.selected]);
        });
        behaviour.add(posRow);

        const indexRow = new Adw.SpinRow({
            title: 'Position in that section',
            subtitle: '0 is the first slot.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1}),
        });
        indexRow.value = settings.get_int('panel-index');
        indexRow.connect('notify::value', () => settings.set_int('panel-index', indexRow.value));
        behaviour.add(indexRow);

        const pollRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'How often, in seconds, to poll Kimi for updated usage.',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 600, step_increment: 10}),
        });
        pollRow.value = settings.get_int('poll-seconds');
        pollRow.connect('notify::value', () => settings.set_int('poll-seconds', pollRow.value));
        behaviour.add(pollRow);

        // ---- about / limitations ----
        const about = new Adw.PreferencesGroup({
            title: 'About',
            description:
                'Reads Kimi Code\'s own credentials file (~/.kimi-code/credentials/kimi-code.json). ' +
                'No separate sign-in. If the access token has expired, run `kimi` once to refresh it, ' +
                'then use Refresh in the popup — this extension does not attempt to refresh tokens itself.',
        });
        page.add(about);
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
