export type WeatherForecastItem = {
  date: string
  week: string
  temperature: string
  weather: string
  wind: string
}

export type WeatherData = {
  city: string
  date: string
  week: string
  currentTemp: string
  humidity: string
  windDirection: string
  windStrength: string
  updateTime: string
  weather: string
  temperatureRange: string
  dressingIndex: string
  dressingAdvice: string
  uvIndex: string
  travelIndex: string
  exerciseIndex: string
  washingIndex: string
  future: WeatherForecastItem[]
}
