{{- define "tresjr-installer.name" -}}tresjr-installer{{- end -}}
{{- define "tresjr-installer.labels" -}}
app.kubernetes.io/name: installer
app.kubernetes.io/instance: tresjr
app.kubernetes.io/part-of: tresjr
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
