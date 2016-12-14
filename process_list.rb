require 'json'
require 'http'
require 'nokogiri'
require 'byebug'

res = []

File.open('npr_station_list.csv').read.gsub("\r","\n").split("\n").take(2).each do |line|
  data = line.split(",")
  dict = {city:data[0], callsign:data[1], band:data[2], frequency: data[3], state: data[4]}
  raw_lookup = HTTP.get("http://radio-locator.com/cgi-bin/finder?call=#{data[1]}&x=13&y=5&sr=Y&s=C").to_s
  lookup = Nokogiri::HTML(raw_lookup)
  byebug
  res.push(dict)
end

File.open('npr_station_list.json', 'w') { |file| file.write(res.to_json) }
