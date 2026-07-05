import { formatSliderValue } from "./format";

export function readForm(formId: string): Record<string, string> {
  const form = document.querySelector<HTMLFormElement>(`#${formId}`);
  if (!form) {
    throw new Error(`Form was not found: ${formId}`);
  }
  const values: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    values[key] = String(value);
  }
  return values;
}

export function formValue(form: HTMLFormElement, name: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return control?.value ?? "";
}

export function setFormValue(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (control) {
    control.value = value;
    const valueTargetId = (control as HTMLElement).dataset.valueTarget;
    if (valueTargetId && control instanceof HTMLInputElement) {
      const valueTarget = document.getElementById(valueTargetId);
      if (valueTarget) {
        valueTarget.textContent = formatSliderValue(control);
      }
    }
  }
}
